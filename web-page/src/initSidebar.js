function initSidebar() {
    jQuery(function ($) {
        let openBtn = $('.bst4-wrapper li.nav-item span.btn');
        let closeBtn = $('.popup-wrapper .close-btn');

        function hideAllPopup() {
            jQuery('.popup-wrapper').hide();
            jQuery('#end-measurement').trigger('click');
        }

        openBtn.click(function () {
            hideAllPopup();

            if( !jQuery(this).parent().hasClass('active') ) {
                let itemDivID = jQuery(this).attr('id');
                let popupID = itemDivID.replace('-btn', '');
                jQuery('#' + popupID).show();
            }

            $(this).parent().toggleClass('active').siblings().not(this).removeClass('active');

            if(window.construktedAssetViewer)
                window.construktedAssetViewer.tryDeactivateTransformEditor();
        });


        closeBtn.click(function () {
            jQuery(this).parents('.popup-wrapper').hide();
            jQuery('#end-measurement').trigger('click');

            if(window.construktedAssetViewer)
                window.construktedAssetViewer.tryDeactivateTransformEditor();
        });

    });

    jQuery('#scroll-down-btn').on('click', function(){
        let toScroll = jQuery('.post-meta').offset().top - jQuery('.featured-image').height() - jQuery('#header').height() + jQuery('.post-meta').height();

        $("html, body").animate({ scrollTop: toScroll }, 600);
    });

    jQuery(window).on('scroll', function(){
        if( jQuery(window).scrollTop() > 200 ) {
            jQuery('#scroll-down-btn').fadeOut(300);
        } else {
            jQuery('#scroll-down-btn').fadeIn(300);
        }
    });


    jQuery('.embed-code-link').on('click', function(){
        jQuery('.embed-content').toggleClass('in');

        return false;
    });

    jQuery(document).on('click', '.variation-action', function(){
        let currentItem = jQuery(this);
        let currentValue = jQuery(this).attr('data-value');
        jQuery('.variations #disk_space').val(currentValue).trigger('change');

        currentItem.parent().addClass('selected').siblings().removeClass('selected');
    });

    jQuery(document).ready(function(){
        if( jQuery('table.variations').length > 0 ) {
            let defaultValue = jQuery('#disk_space').val();

            jQuery('.variation-action[data-value="'+defaultValue+'"]').trigger('click');

            let currentSubValue = jQuery('.flex-row').data('current');

            if( currentSubValue > 0 ) {
                jQuery('.variation-action[data-value="'+currentSubValue+'"]').trigger('click');
            }
        }
    });
}

export {
    initSidebar
}